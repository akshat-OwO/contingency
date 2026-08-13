import type { ThemeProviderProps } from "next-themes";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ReactNode } from "react";

type AppThemeProviderProps = ThemeProviderProps & {
  children: ReactNode;
};

const ThemeProvider = ({ children, ...props }: AppThemeProviderProps) => (
  <NextThemesProvider {...props}>{children}</NextThemesProvider>
);

export { ThemeProvider };
