"use client";

import { useState, type ReactNode } from "react";

interface Props {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * Generic collapsible used for the side-bar standings and the upcoming-race
 * list. Header is always rendered; content slides under a `grid-template-rows`
 * animation so we don't need to measure heights or use `max-height` hacks.
 */
export function CollapsiblePanel({
  title,
  subtitle,
  defaultOpen = false,
  children,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="overflow-hidden rounded-3xl border border-white/10 bg-[#0a0a12]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-white/[0.03]"
      >
        <div className="flex flex-col">
          <span className="text-sm font-bold uppercase tracking-widest text-white">
            {title}
          </span>
          {subtitle && (
            <span className="text-[11px] text-white/55">{subtitle}</span>
          )}
        </div>
        <span
          aria-hidden
          className={`grid h-7 w-7 place-items-center rounded-full bg-white/10 text-white transition-transform ${
            open ? "rotate-180" : ""
          }`}
        >
          <svg
            viewBox="0 0 12 12"
            className="h-3 w-3"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path d="M2 4 L 6 8 L 10 4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-500 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="border-t border-white/5">{children}</div>
        </div>
      </div>
    </section>
  );
}
