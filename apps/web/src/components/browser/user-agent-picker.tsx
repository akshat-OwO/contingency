import { selectableUserAgentProfiles } from "@contingency/protocol";
import type { UserAgentProfileId } from "@contingency/protocol";
import { LaptopIcon, TriangleAlertIcon } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Only the identities Chromium can genuinely reproduce are offered for new
 * work: Safari and Firefox profiles could disguise Chromium with a string but
 * never behave as those engines ([ADR
 * 0013](../../../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 */
type UserAgentProfile = (typeof selectableUserAgentProfiles)[number];

const userAgentGroups: {
  readonly group: string;
  readonly profiles: UserAgentProfile[];
}[] = [];

for (const profile of selectableUserAgentProfiles) {
  const existingGroup = userAgentGroups.find(
    ({ group }) => group === profile.group
  );
  if (existingGroup === undefined) {
    userAgentGroups.push({ group: profile.group, profiles: [profile] });
  } else {
    existingGroup.profiles.push(profile);
  }
}

interface UserAgentPickerProps {
  readonly compatibilityWarning?: string;
  readonly disabled: boolean;
  readonly onValueChange: (value: UserAgentProfileId) => void;
  readonly value: UserAgentProfileId;
}

const UserAgentPicker = ({
  compatibilityWarning,
  disabled,
  onValueChange,
  value,
}: UserAgentPickerProps) => {
  const selectedProfile = selectableUserAgentProfiles.find(
    (profile) => profile.id === value
  );

  return (
    <div className="flex items-center gap-1">
      <Select
        disabled={disabled}
        onValueChange={(nextValue) => {
          const profile = selectableUserAgentProfiles.find(
            ({ id }) => id === nextValue
          );
          if (profile !== undefined) {
            onValueChange(profile.id);
          }
        }}
        value={value}
      >
        <SelectTrigger aria-label="User agent" className="w-48" size="sm">
          <LaptopIcon aria-hidden="true" className="size-3.5" />
          <SelectValue>
            {selectedProfile?.label ?? "Browser default"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent align="start" className="w-80">
          {userAgentGroups.map(({ group, profiles }) => (
            <SelectGroup key={group}>
              <SelectLabel>{group}</SelectLabel>
              {profiles.map((profile) => (
                <SelectItem key={profile.id} value={profile.id}>
                  {profile.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      {compatibilityWarning === undefined ? null : (
        <Tooltip>
          <TooltipTrigger
            aria-label="Legacy browser identity compatibility warning"
            className="text-amber-600 dark:text-amber-400"
          >
            <TriangleAlertIcon aria-hidden="true" className="size-4" />
          </TooltipTrigger>
          <TooltipContent>{compatibilityWarning}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
};

export { UserAgentPicker };
