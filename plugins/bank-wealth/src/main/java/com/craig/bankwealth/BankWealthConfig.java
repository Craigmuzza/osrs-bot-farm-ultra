package com.craig.bankwealth;

import net.runelite.client.config.*;

@ConfigGroup("bankwealth")
public interface BankWealthConfig extends Config
{
    @ConfigItem(
        keyName = "minLogSeconds",
        name = "Min log interval (s)",
        description = "Minimum seconds between JSON writes"
    )
    default int minLogSeconds() { return 10; }

    @ConfigItem(
        keyName = "onlyWhenBankOpen",
        name = "Only when bank UI open",
        description = "Write entries only when the bank interface is open"
    )
    default boolean onlyWhenBankOpen() { return true; }

    @ConfigItem(
        keyName = "dedupe",
        name = "Skip identical entries",
        description = "Do not write when values have not changed"
    )
    default boolean dedupe() { return true; }
}
