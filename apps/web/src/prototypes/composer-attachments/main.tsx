import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

import { ComposerAttachmentsGallery } from "./gallery";

import "@/styles.css";

/**
 * A standalone Vite entry, served only by the dev server at
 * `/prototypes/composer-attachments.html`. It is outside the app router and
 * the production build, so it cannot shadow a real route.
 */
const rootElement = document.querySelector("#root");

if (!(rootElement instanceof HTMLElement)) {
  throw new Error("Root element #root was not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      disableTransitionOnChange
      enableSystem
      storageKey="contingency-theme"
    >
      <TooltipProvider>
        <ComposerAttachmentsGallery />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>
);
