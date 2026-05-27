"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // RaceData is large and immutable per session; one fetch per mount
            // is fine. Disable retries on the warm-build path — failure is
            // usually "backend down" and retries just delay the error.
            retry: false,
            staleTime: Number.POSITIVE_INFINITY,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
