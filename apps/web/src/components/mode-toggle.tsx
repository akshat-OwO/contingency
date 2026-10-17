import { MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { flushSync } from "react-dom";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const ModeToggle = () => {
  const { setTheme } = useTheme();
  // Light and dark cross-fade rather than flash: the view transition captures
  // the old theme, and the synchronous update applies the new one before the
  // new frame is captured. next-themes still turns other transitions off for
  // the switch, so controls don't animate one by one.
  const changeTheme = (theme: "dark" | "light" | "system") => {
    if (!("startViewTransition" in document)) {
      setTheme(theme);
      return;
    }
    document.startViewTransition(() => {
      flushSync(() => setTheme(theme));
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label="Change color theme"
            className="relative"
            size="icon"
            variant="outline"
          />
        }
      >
        <SunIcon className="scale-100 rotate-0 opacity-100 transition-[opacity,transform] motion-reduce:transition-none dark:scale-95 dark:-rotate-90 dark:opacity-0" />
        <MoonIcon className="absolute scale-95 rotate-90 opacity-0 transition-[opacity,transform] motion-reduce:transition-none dark:scale-100 dark:rotate-0 dark:opacity-100" />
        <span className="sr-only">Change color theme</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => changeTheme("light")}>
          Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => changeTheme("dark")}>
          Dark
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => changeTheme("system")}>
          System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export { ModeToggle };
