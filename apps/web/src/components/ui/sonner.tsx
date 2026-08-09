"use client";

import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { Toaster as Sonner } from "sonner";
import type { ToasterProps } from "sonner";

const resolveTheme = (
  theme: string | undefined
): NonNullable<ToasterProps["theme"]> => {
  if (theme === "light" || theme === "dark" || theme === "system") {
    return theme;
  }

  return "system";
};

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme } = useTheme();

  return (
    <Sonner
      theme={resolveTheme(theme)}
      className="toaster group"
      icons={{
        error: <OctagonXIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
        success: <CircleCheckIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
      }}
      style={
        {
          "--border-radius": "var(--radius)",
          "--normal-bg": "var(--popover)",
          "--normal-border": "var(--border)",
          "--normal-text": "var(--popover-foreground)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
