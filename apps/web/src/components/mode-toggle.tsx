import { MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const ModeToggle = () => {
  const { setTheme } = useTheme();

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
        <DropdownMenuItem onClick={() => setTheme("light")}>
          Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("dark")}>
          Dark
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("system")}>
          System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export { ModeToggle };
