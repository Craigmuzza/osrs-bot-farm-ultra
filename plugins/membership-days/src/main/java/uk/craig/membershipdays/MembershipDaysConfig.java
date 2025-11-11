package uk.craig.membershipdays;

import net.runelite.client.config.*;

@ConfigGroup("membershipdays")
public interface MembershipDaysConfig extends Config
{
    @ConfigItem(
        keyName = "outputFolderName",
        name = "Output folder name",
        description = "Folder inside .runelite to write files into"
    )
    default String outputFolderName() { return "membership-days"; }

    @ConfigItem(
        keyName = "writeJson",
        name = "Also write JSON",
        description = "Write JSON alongside the .txt"
    )
    default boolean writeJson() { return false; }

    @ConfigItem(
        keyName = "throttleMs",
        name = "Scan throttle (ms)",
        description = "Minimum ms between full widget scans"
    )
    default int throttleMs() { return 1500; }
}
