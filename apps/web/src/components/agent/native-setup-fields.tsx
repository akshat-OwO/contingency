import type { ReactNode } from "react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import type { NativeCondition } from "./native-condition";

/** Roles agent-device reports that a person can name on a screen. */
const ROLES = ["text", "group", "heading", "button", "image"] as const;

export const Choice = ({
  label,
  value,
  items,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly items: readonly { readonly value: string; readonly label: string }[];
  readonly onChange: (value: string) => void;
}) => (
  <Select
    items={[...items]}
    value={value}
    onValueChange={(next) => {
      if (next !== null) {
        onChange(next);
      }
    }}
  >
    <SelectTrigger aria-label={label} className="w-full" variant="island">
      <SelectValue />
    </SelectTrigger>
    <SelectContent variant="island">
      {items.map((item) => (
        <SelectItem key={item.value} value={item.value}>
          {item.label}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

/** A titled part of a start card, named as a group for automation and readers. */
export const Part = ({
  children,
  description,
  disabled = false,
  title,
}: {
  readonly children: ReactNode;
  readonly description?: string;
  readonly disabled?: boolean;
  readonly title: string;
}) => (
  <fieldset className="grid min-w-0 gap-1.5" disabled={disabled}>
    <legend className="mb-1.5 text-[13px] font-medium">{title}</legend>
    {description === undefined ? null : (
      <p className="text-muted-foreground -mt-1 text-xs">{description}</p>
    )}
    {children}
  </fieldset>
);

/**
 * A role and an element name, with visible Role and Element captions; each
 * control keeps its full accessible name, which contains the caption.
 */
export const ConditionInput = ({
  label,
  onChange,
  placeholder,
  roleLabel = `${label} role`,
  value,
}: {
  readonly label: string;
  readonly onChange: (value: NativeCondition) => void;
  readonly placeholder: string;
  /** The role combobox's name; `<label> role` unless a platform names it. */
  readonly roleLabel?: string;
  readonly value: NativeCondition;
}) => (
  <div className="flex gap-1.5">
    <div className="w-32 shrink-0 space-y-1">
      <span
        aria-hidden="true"
        className="text-muted-foreground block text-xs font-medium"
      >
        Role
      </span>
      <Choice
        label={roleLabel}
        value={value.role}
        items={ROLES.map((role) => ({ label: role, value: role }))}
        onChange={(role) => onChange({ ...value, role })}
      />
    </div>
    <div className="min-w-0 flex-1 space-y-1">
      <span
        aria-hidden="true"
        className="text-muted-foreground block text-xs font-medium"
      >
        Element
      </span>
      <Input
        aria-label={label}
        onChange={(event) =>
          onChange({ ...value, name: event.currentTarget.value })
        }
        placeholder={placeholder}
        value={value.name}
        variant="island"
      />
    </div>
  </div>
);
