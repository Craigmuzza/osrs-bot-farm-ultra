package com.craig.bankwealth;

import net.runelite.client.ui.PluginPanel;

import javax.swing.*;
import java.awt.*;

final class BankWealthPanel extends PluginPanel
{
    private final JLabel bankValue = new JLabel("Bank GE Value: —");
    private final JLabel bankCoins = new JLabel("Bank Coins: —");
    private final JLabel invCoins  = new JLabel("Inventory Coins: —");

    BankWealthPanel()
    {
        setLayout(new GridLayout(0, 1, 4, 4));
        add(title("Bank Wealth"));
        add(bankValue);
        add(bankCoins);
        add(invCoins);
    }

    void update(long bankValueGp, long bankCoinsGp, long invCoinsGp)
    {
        bankValue.setText("Bank GE Value: " + fmt(bankValueGp) + " gp");
        bankCoins.setText("Bank Coins: " + fmt(bankCoinsGp));
        invCoins.setText("Inventory Coins: " + fmt(invCoinsGp));
    }

    private static JLabel title(String s)
    {
        final JLabel l = new JLabel(s);
        l.setFont(l.getFont().deriveFont(Font.BOLD, 14f));
        return l;
    }

    private static String fmt(long n)
    {
        if (n >= 1_000_000_000L) return String.format("%.2fB", n / 1_000_000_000.0);
        if (n >= 1_000_000L)     return String.format("%.2fM", n / 1_000_000.0);
        if (n >= 1_000L)         return String.format("%.1fk", n / 1_000.0);
        return Long.toString(n);
    }
}