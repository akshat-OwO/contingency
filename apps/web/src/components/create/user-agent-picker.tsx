import { userAgentProfiles } from "@contingency/protocol";
import type { UserAgentProfileId } from "@contingency/protocol";
import { LaptopIcon } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type UserAgentProfile = (typeof userAgentProfiles)[number];

const userAgentGroups: {
  readonly group: string;
  readonly profiles: UserAgentProfile[];
}[] = [];

for (const profile of userAgentProfiles) {
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
  readonly disabled: boolean;
  readonly onValueChange: (value: UserAgentProfileId) => void;
  readonly value: UserAgentProfileId;
}

const UserAgentPicker = ({
  disabled,
  onValueChange,
  value,
}: UserAgentPickerProps) => {
  const selectedProfile = userAgentProfiles.find(
    (profile) => profile.id === value
  );

  return (
    <Select
      disabled={disabled}
      onValueChange={(nextValue) => {
        const profile = userAgentProfiles.find(({ id }) => id === nextValue);
        if (profile !== undefined) {
          onValueChange(profile.id);
        }
      }}
      value={value}
    >
      <SelectTrigger aria-label="User agent" className="w-48" size="sm">
        <LaptopIcon aria-hidden="true" className="size-3.5" />
        <SelectValue>{selectedProfile?.label ?? "Browser default"}</SelectValue>
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
  );
};

export { UserAgentPicker };
