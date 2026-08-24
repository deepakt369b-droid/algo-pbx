"use client";

// Manual App Router Emotion cache provider — MUI's own documented pattern
// (mui.com/material-ui/integrations/nextjs/#app-router), used instead of
// the @mui/material-nextjs package's AppRouterCacheProvider. That package
// pulled in a version-mismatched nested @mui/system (visible as
// node_modules/@mui/material/node_modules/@mui/system alongside the
// top-level one) and its v14-appRouter helper called
// unstable_createUseMediaQuery from the wrong copy, crashing static page
// generation with "is not a function". This ~40-line manual provider has
// no such cross-package coupling — it only needs @emotion/react/cache,
// which the theme layer already depends on directly.
import * as React from "react";
import createCache from "@emotion/cache";
import { useServerInsertedHTML } from "next/navigation";
import { CacheProvider } from "@emotion/react";

export function NextEmotionCacheProvider({ children }: { children: React.ReactNode }) {
  const [{ cache, flush }] = React.useState(() => {
    const cache = createCache({ key: "mui" });
    cache.compat = true;
    const prevInsert = cache.insert;
    let inserted: string[] = [];
    cache.insert = (...args) => {
      const serialized = args[1];
      if (cache.inserted[serialized.name] === undefined) {
        inserted.push(serialized.name);
      }
      return prevInsert(...args);
    };
    const flush = () => {
      const prevInserted = inserted;
      inserted = [];
      return prevInserted;
    };
    return { cache, flush };
  });

  useServerInsertedHTML(() => {
    const names = flush();
    if (names.length === 0) return null;
    let styles = "";
    for (const name of names) {
      styles += cache.inserted[name];
    }
    return (
      <style
        key="mui-emotion"
        data-emotion={`${cache.key} ${names.join(" ")}`}
        dangerouslySetInnerHTML={{ __html: styles }}
      />
    );
  });

  return <CacheProvider value={cache}>{children}</CacheProvider>;
}
