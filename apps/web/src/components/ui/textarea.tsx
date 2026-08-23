import * as React from "react";
import { cn } from "@/lib/utils";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(({ className, ...props }, ref) =>
  <textarea ref={ref} className={cn("flex min-h-16 w-full resize-none rounded-sm border border-border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50", className)} {...props} />);
Textarea.displayName = "Textarea";
