import { useEffect, useState } from "react";

/**
 * Browser online/offline signal. Status flips drive two behaviors:
 * QueryBoundary shows the offline error variant, and affected queries refetch
 * automatically the moment connectivity returns (no stale "dead" UI).
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  useEffect(() => {
    const goOnline = (): void => setOnline(true);
    const goOffline = (): void => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}

/** True when an error is a connectivity failure rather than a server answer. */
export function isOfflineError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: unknown }).status === 0
  );
}
