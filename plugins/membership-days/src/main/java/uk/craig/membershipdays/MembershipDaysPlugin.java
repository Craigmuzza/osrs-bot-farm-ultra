package uk.craig.membershipdays;

import com.google.inject.Provides;
import net.runelite.api.Client;
import net.runelite.api.GameState;
import net.runelite.api.Player;
import net.runelite.api.events.GameStateChanged;
import net.runelite.api.events.WidgetLoaded;
import net.runelite.api.widgets.Widget;
import net.runelite.client.config.ConfigManager;
import net.runelite.client.eventbus.Subscribe;
import net.runelite.client.plugins.Plugin;
import net.runelite.client.plugins.PluginDescriptor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.inject.Inject;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.function.Consumer;

@PluginDescriptor(
        name = "Membership Days (Auto UI)",
        description = "Auto-detects membership days from title screen or Account Management UI and writes to .runelite/membership-days/<rsn>.txt",
        tags = {"membership","days","export","file","ui","widget"}
)
public class MembershipDaysPlugin extends Plugin
{
    private static final Logger log = LoggerFactory.getLogger(MembershipDaysPlugin.class);

    @Inject private Client client;
    @Inject private MembershipDaysConfig config;
    @Inject private ConfigManager configManager;

    private static final List<Pattern> PATTERNS = List.of(
            Pattern.compile("\\b(\\d+)\\s+days?\\s+of\\s+membership\\s+left\\b", Pattern.CASE_INSENSITIVE),
            Pattern.compile("\\bexpire[s]?\\s+in\\s+(\\d+)\\s+days?\\b", Pattern.CASE_INSENSITIVE),
            Pattern.compile("\\bmembership\\b[^\\d]*(\\d+)\\s+days?\\s+(remaining|left)\\b", Pattern.CASE_INSENSITIVE),
            Pattern.compile("\\byou\\s+are\\s+a\\s+member\\b[^\\d]*(\\d+)\\s+days?\\b", Pattern.CASE_INSENSITIVE)
    );

    private Integer pendingFromTitle = null;
    private Integer lastWrittenDays = null;
    private String  lastWrittenRsn = null;
    private final AtomicLong lastScanMs = new AtomicLong(0);

    @Provides
    MembershipDaysConfig provideConfig(ConfigManager cm) { return cm.getConfig(MembershipDaysConfig.class); }

    @Override
	protected void startUp() {
		log.info("Membership Days (Auto UI) started");
		try {
			Path base = java.nio.file.Paths.get(System.getProperty("user.home"), ".runelite", "membership-days");
			java.nio.file.Files.createDirectories(base);
			java.nio.file.Files.writeString(
				base.resolve("_loaded.txt"),
				java.time.Instant.now().toString() + " loaded\n",
				java.nio.charset.StandardCharsets.UTF_8,
				java.nio.file.StandardOpenOption.CREATE,
				java.nio.file.StandardOpenOption.APPEND
			);
		} catch (Exception e) {
			log.warn("Init failed", e);
		}
	}

    @Override protected void shutDown() { log.info("Membership Days (Auto UI) stopped"); }

    @Subscribe
    public void onWidgetLoaded(WidgetLoaded e)
    {
        // Scan only the group that just loaded.
        scanGroup(e.getGroupId());
        flushPendingAfterLogin();
    }

    @Subscribe
    public void onGameStateChanged(GameStateChanged e)
    {
        if (e.getGameState() == GameState.LOGGED_IN)
        {
            flushPendingAfterLogin();
            wideScanOnceThrottled();
        }
    }

    private void wideScanOnceThrottled()
    {
        long now = System.currentTimeMillis();
        if (now - lastScanMs.get() < Math.max(250, config.throttleMs())) return;
        lastScanMs.set(now);

        // We do not use client.getWidgets() (not available). Instead we rely on recently loaded roots
        // by probing a few common group roots that are frequently present; failures are ignored.
        // This is best-effort; onWidgetLoaded will still catch the rest.
        for (int groupId = 0; groupId < 800; groupId++) // safe, most groups are <800
        {
            scanGroup(groupId);
        }
    }

    private void scanGroup(int groupId)
    {
        try
        {
            Widget root = client.getWidget(groupId, 0);
            if (root == null) return;

            traverse(root, this::checkWidget);
        }
        catch (Throwable t)
        {
            // Ignore unknown groups
        }
    }

    private void traverse(Widget w, Consumer<Widget> visitor)
    {
        if (w == null) return;
        visitor.accept(w);

        Widget[] a = w.getStaticChildren();
        if (a != null) for (Widget c : a) traverse(c, visitor);

        Widget[] b = w.getDynamicChildren();
        if (b != null) for (Widget c : b) traverse(c, visitor);

        Widget[] c = w.getNestedChildren();
        if (c != null) for (Widget n : c) traverse(n, visitor);
    }

    private void checkWidget(Widget w)
    {
        String txt = safe(w.getText());
        if (!txt.isEmpty())
        {
            Integer d = parseDays(txt);
            if (d != null) { handleDays(d); return; }
        }

        String nm = safe(w.getName());
        if (!nm.isEmpty())
        {
            Integer d = parseDays(nm);
            if (d != null) { handleDays(d); }
        }
        // No tooltip call here (not present in this API version)
    }

    private void handleDays(int days)
    {
        GameState gs = client.getGameState();
        if (gs == GameState.LOGIN_SCREEN || gs == GameState.LOGGING_IN)
        {
            pendingFromTitle = days;
            return;
        }

        if (gs == GameState.LOGGED_IN)
        {
            String rsn = rsn();
            if (rsn == null) return;

            if (Objects.equals(lastWrittenRsn, rsn) && Objects.equals(lastWrittenDays, days)) return;

            writeOut(rsn, days, "ui");
            lastWrittenRsn = rsn;
            lastWrittenDays = days;
        }
    }

    private void flushPendingAfterLogin()
    {
        if (pendingFromTitle == null) return;
        if (client.getGameState() != GameState.LOGGED_IN) return;

        String rsn = rsn();
        if (rsn == null) return;

        int days = pendingFromTitle;
        pendingFromTitle = null;

        if (!Objects.equals(lastWrittenRsn, rsn) || !Objects.equals(lastWrittenDays, days))
        {
            writeOut(rsn, days, "title");
            lastWrittenRsn = rsn;
            lastWrittenDays = days;
        }
    }

    private Integer parseDays(String text)
    {
        String t = text == null ? "" : text.replace('\u00A0', ' ').trim();
        if (t.isEmpty()) return null;
        for (Pattern p : PATTERNS)
        {
            Matcher m = p.matcher(t);
            if (m.find())
            {
                try { return Integer.parseInt(m.group(1)); } catch (NumberFormatException ignored) {}
            }
        }
        return null;
    }

    private String rsn()
    {
        Player p = client.getLocalPlayer();
        if (p == null) return null;
        String n = p.getName();
        if (n == null) return null;
        return n.replaceAll("[^A-Za-z0-9 _.-]", "_");
    }

    private String safe(String s) { return s == null ? "" : s; }

    private void writeOut(String rsn, int days, String source)
    {
        try
        {
            Path base = Paths.get(System.getProperty("user.home"), ".runelite", config.outputFolderName());
            Files.createDirectories(base);

            Path txt = base.resolve(rsn + ".txt");
            Files.writeString(txt, Integer.toString(days), StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);

            if (config.writeJson())
            {
                String json = String.format(
                        "{\"rsn\":\"%s\",\"days\":%d,\"captured_at\":\"%s\",\"source\":\"%s\"}\n",
                        rsn, days, Instant.now().toString(), source);
                Path js = base.resolve(rsn + ".json");
                Files.writeString(js, json, StandardCharsets.UTF_8,
                        StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
            }
        }
        catch (IOException ioe)
        {
            log.warn("MembershipDays write failed", ioe);
        }
    }
}
