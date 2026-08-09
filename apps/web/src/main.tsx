import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider, ToastProvider } from "@profit/ui";
import App from "./App";
import { AdminApp } from "./admin/AdminApp";
import { AuthProvider } from "./lib/auth-context";
import { createAppQueryClient } from "./lib/query-client";
import "./styles.css";

/**
 * Provider order is load-bearing:
 *   Theme (tokens) → QueryClient (data) → Toast (feedback) → Auth (session)
 * AuthProvider owns the ApiClient and exposes it via context; the shell's
 * realtime client turns socket events into query invalidations on the same
 * QueryClient created here.
 *
 * Boot branch (M5): /admin is the platform-operator console — a deliberately
 * SEPARATE trust boundary from the merchant app. It must never load the
 * Shopify session machinery (App Bridge, install gate, embedded bootstrap),
 * so the tree splits here before any of it mounts.
 */
const IS_ADMIN = window.location.pathname.startsWith("/admin");

function Root(): ReactNode {
  if (IS_ADMIN) {
    return (
      <ThemeProvider>
        <QueryClientProvider client={createAppQueryClient()}>
          <ToastProvider>
            <BrowserRouter>
              <AdminApp />
            </BrowserRouter>
          </ToastProvider>
        </QueryClientProvider>
      </ThemeProvider>
    );
  }
  return (
    <ThemeProvider>
      <QueryClientProvider client={createAppQueryClient()}>
        <ToastProvider>
          <AuthProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </AuthProvider>
        </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("Root element #root is missing from index.html");

createRoot(rootElement).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
