import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider, ToastProvider } from "@profit/ui";
import App from "./App";
import { AuthProvider } from "./lib/auth-context";
import { createAppQueryClient } from "./lib/query-client";
import "./styles.css";

/**
 * Provider order is load-bearing:
 *   Theme (tokens) → QueryClient (data) → Toast (feedback) → Auth (session)
 * AuthProvider owns the ApiClient and exposes it via context; the shell's
 * realtime client turns socket events into query invalidations on the same
 * QueryClient created here.
 */

const queryClient = createAppQueryClient();
const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("Root element #root is missing from index.html");

createRoot(rootElement).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <AuthProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </AuthProvider>
        </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
