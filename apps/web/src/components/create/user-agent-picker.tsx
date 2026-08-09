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

const groups = [...new Set(userAgentProfiles.map(({ group }) => group))];

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
        {groups.map((group) => (
          <SelectGroup key={group}>
            <SelectLabel>{group}</SelectLabel>
            {userAgentProfiles
              .filter((profile) => profile.group === group)
              .map((profile) => (
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
