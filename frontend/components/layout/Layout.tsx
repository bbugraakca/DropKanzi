import * as React from "react";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { MobileNav } from "./MobileNav";
import { cn } from "@/lib/utils";

export function Layout({
  children,
  title,
  breadcrumb,
  description,
  fullWidth,
  flush,
}: {
  children: React.ReactNode;
  title: string;
  breadcrumb?: string;
  description?: string;
  fullWidth?: boolean;
  flush?: boolean;
}) {
  return (
    <div className="min-h-screen bg-bg">
      <div className="flex min-h-screen">
        <div className="hidden md:flex">
          <Sidebar />
        </div>
        <div className="flex min-w-0 flex-1 flex-col min-h-screen bg-bg pb-14 md:pb-0">
          <TopBar
            title={title}
            breadcrumb={breadcrumb}
            description={description}
            compact={fullWidth && flush}
          />
          <main
            className={cn(
              "flex-1 flex flex-col min-h-0 w-full page-enter",
              fullWidth
                ? cn("max-w-none", flush ? "px-7 py-7 md:px-8" : "px-7 py-7 md:px-8")
                : "px-7 py-7 md:px-8 max-w-[1200px]"
            )}
          >
            {children}
          </main>
        </div>
      </div>
      <MobileNav />
    </div>
  );
}
