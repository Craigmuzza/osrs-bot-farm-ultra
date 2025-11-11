package com.craig.bankwealth;

import com.google.gson.*;
import com.google.inject.Provides;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.GridLayout;
import java.awt.image.BufferedImage;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.text.NumberFormat;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import javax.inject.Inject;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.SwingUtilities;

import net.runelite.api.Client;
import net.runelite.api.InventoryID;
import net.runelite.api.Item;
import net.runelite.api.ItemContainer;
import net.runelite.api.ItemID;
import net.runelite.api.events.ItemContainerChanged;
import net.runelite.api.events.WidgetLoaded;
import net.runelite.api.widgets.WidgetID;
import net.runelite.api.widgets.WidgetInfo;

import net.runelite.client.callback.ClientThread;
import net.runelite.client.config.ConfigManager;
import net.runelite.client.eventbus.Subscribe;
import net.runelite.client.game.ItemManager;
import net.runelite.client.plugins.Plugin;
import net.runelite.client.plugins.PluginDescriptor;
import net.runelite.client.ui.ClientToolbar;
import net.runelite.client.ui.NavigationButton;
import net.runelite.client.ui.PluginPanel;
import net.runelite.client.util.ImageUtil;

@PluginDescriptor(
        name = "Bank Wealth",
        description = "Tracks bank GE value and coins. Logs per-username JSON.",
        tags = {"bank", "value", "coins", "json", "log"}
)
public class BankWealthPlugin extends Plugin
{
    @Inject private Client client;
    @Inject private ClientThread clientThread;
    @Inject private ItemManager itemManager;
    @Inject private ClientToolbar clientToolbar;
    @Inject private BankWealthConfig config;

    private NavigationButton nav;
    private BankWealthPanel panel;

    private Path baseDir;
    private static final DateTimeFormatter TS_FMT = DateTimeFormatter.ISO_LOCAL_DATE_TIME;
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    // dedupe + throttle
    private long lastBankValue = Long.MIN_VALUE;
    private long lastBankCoins = Long.MIN_VALUE;
    private long lastInvCoins  = Long.MIN_VALUE;
    private long lastWriteMs   = 0L;

    @Provides
    BankWealthConfig provideConfig(ConfigManager cm) { return cm.getConfig(BankWealthConfig.class); }

    @Override
    protected void startUp()
    {
        BufferedImage icon = ImageUtil.loadImageResource(getClass(), "wealth.png");
        if (icon == null)
        {
            icon = new BufferedImage(16, 16, BufferedImage.TYPE_INT_ARGB);
            Graphics2D g = icon.createGraphics();
            g.setColor(Color.YELLOW);
            g.drawString("GP", 2, 12);
            g.dispose();
        }

        panel = new BankWealthPanel();
        nav = NavigationButton.builder()
                .tooltip("Bank Wealth")
                .priority(5)
                .icon(icon)
                .panel(panel)
                .build();
        clientToolbar.addNavigation(nav);

        // C:\Users\<user>\.runelite\bank-wealth
        String home = System.getProperty("user.home");
        baseDir = Paths.get(home, ".runelite", "bank-wealth");
        try { Files.createDirectories(baseDir); } catch (Exception ignored) {}

        recalcAsync();
    }

    @Override
    protected void shutDown()
    {
        if (nav != null)
        {
            clientToolbar.removeNavigation(nav);
            nav = null;
        }
        panel = null;
    }

    @Subscribe
    public void onWidgetLoaded(WidgetLoaded e)
    {
        if (e.getGroupId() == WidgetID.BANK_GROUP_ID)
        {
            recalcAsync();
        }
    }

    @Subscribe
    public void onItemContainerChanged(ItemContainerChanged e)
    {
        int id = e.getContainerId();
        if (id == InventoryID.INVENTORY.getId() || id == InventoryID.BANK.getId())
        {
            recalcAsync();
        }
    }

    private void recalcAsync()
    {
        clientThread.invokeLater(this::recalcBank);
    }

    private boolean isBankOpen()
    {
        return client.getWidget(WidgetInfo.BANK_CONTAINER) != null;
    }

    private void recalcBank()
    {
        long bankValue = 0;
        long bankCoins = 0;
        long invCoins  = 0;

        ItemContainer bank = client.getItemContainer(InventoryID.BANK);
        boolean bankHasData = bank != null && bank.getItems() != null && bank.getItems().length > 0;

        // optional: only write when bank UI is actually open
        if (config.onlyWhenBankOpen() && !isBankOpen())
        {
            // still update panel with last known values; skip write
            SwingUtilities.invokeLater(() -> {
                if (panel != null) panel.setValues(lastBankValue == Long.MIN_VALUE ? 0 : lastBankValue,
                                                   lastBankCoins == Long.MIN_VALUE ? 0 : lastBankCoins,
                                                   lastInvCoins  == Long.MIN_VALUE ? 0 : lastInvCoins);
            });
            return;
        }

        if (bankHasData)
        {
            for (Item it : bank.getItems())
            {
                int id = it.getId();
                int qty = it.getQuantity();
                if (id <= 0 || qty <= 0) continue;

                if (id == ItemID.COINS_995) bankCoins += qty;

                int ge = 0;
                try { ge = itemManager.getItemPrice(id); } catch (Exception ignored) {}
                bankValue += (long) ge * (long) qty;
            }
        }

        ItemContainer inv = client.getItemContainer(InventoryID.INVENTORY);
        if (inv != null && inv.getItems() != null)
        {
            for (Item it : inv.getItems())
            {
                if (it.getId() == ItemID.COINS_995) invCoins += it.getQuantity();
            }
        }

        // panel update always
        final long fBankValue = bankValue, fBankCoins = bankCoins, fInvCoins = invCoins;
        SwingUtilities.invokeLater(() -> {
            if (panel != null) panel.setValues(fBankValue, fBankCoins, fInvCoins);
        });

        // skip writing if no bank data yet to avoid 0,0,0 spam
        if (!bankHasData) return;

        // throttle + dedupe
        long now = System.currentTimeMillis();
        long minGapMs = Math.max(0, config.minLogSeconds()) * 1000L;
        boolean due = (now - lastWriteMs) >= minGapMs;

        boolean changed = true;
        if (config.dedupe())
        {
            changed = bankValue != lastBankValue || bankCoins != lastBankCoins || invCoins != lastInvCoins;
        }

        if (due && changed)
        {
            String rsn = client.getLocalPlayer() != null ? client.getLocalPlayer().getName() : "unknown";
            writeUserJson(rsn, bankValue, bankCoins, invCoins);

            lastBankValue = bankValue;
            lastBankCoins = bankCoins;
            lastInvCoins  = invCoins;
            lastWriteMs   = now;
        }
    }

    private void writeUserJson(String rsn, long bankValue, long bankCoins, long invCoins)
    {
        try
        {
            String safe = sanitiseFileName(rsn == null || rsn.isEmpty() ? "unknown" : rsn);
            Path file = baseDir.resolve(safe + ".json");

            JsonObject root;
            if (Files.exists(file))
            {
                try
                {
                    String txt = Files.readString(file, StandardCharsets.UTF_8);
                    JsonElement je = new JsonParser().parse(txt); // Gson 2.8.5 compatible
                    root = je != null && je.isJsonObject() ? je.getAsJsonObject() : new JsonObject();
                }
                catch (Exception ex)
                {
                    root = new JsonObject();
                }
            }
            else
            {
                root = new JsonObject();
            }

            root.addProperty("rsn", rsn);
            root.addProperty("lastUpdated", TS_FMT.format(LocalDateTime.now()));

            JsonArray entries = root.has("entries") && root.get("entries").isJsonArray()
                    ? root.getAsJsonArray("entries")
                    : new JsonArray();

            JsonObject entry = new JsonObject();
            entry.addProperty("timestamp", TS_FMT.format(LocalDateTime.now()));
            entry.addProperty("bank_ge_value", bankValue);
            entry.addProperty("bank_coins", bankCoins);
            entry.addProperty("inventory_coins", invCoins);
            entries.add(entry);
            root.add("entries", entries);

            byte[] out = GSON.toJson(root).getBytes(StandardCharsets.UTF_8);
            Path tmp = file.resolveSibling(file.getFileName().toString() + ".tmp");
            Files.write(tmp, out, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
            try { Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE); }
            catch (Exception ignore) { Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING); }
        }
        catch (Exception ignored) {}
    }

    private static String sanitiseFileName(String s)
    {
        return s.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
    }

    // Minimal panel
    private static class BankWealthPanel extends PluginPanel
    {
        private final JLabel bankVal = new JLabel("Bank GE: 0 gp");
        private final JLabel bankGp  = new JLabel("Bank coins: 0");
        private final JLabel invGp   = new JLabel("Inventory coins: 0");

        BankWealthPanel()
        {
            setLayout(new BorderLayout());
            JPanel p = new JPanel(new GridLayout(0, 1, 0, 4));
            p.add(bankVal);
            p.add(bankGp);
            p.add(invGp);
            add(p, BorderLayout.NORTH);
        }

        void setValues(long bankValue, long bankCoins, long invCoins)
        {
            NumberFormat nf = NumberFormat.getInstance();
            bankVal.setText("Bank GE: " + nf.format(bankValue) + " gp");
            bankGp.setText("Bank coins: " + nf.format(bankCoins));
            invGp.setText("Inventory coins: " + nf.format(invCoins));
        }
    }
}
