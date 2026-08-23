import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(({ className, ...props }, ref) =>
  <input ref={ref} className={cn("flex h-9 w-full rounded-sm border border-border bg-transparent px-3 py-1 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50", className)} {...props} />);
Input.displayName = "Input";
