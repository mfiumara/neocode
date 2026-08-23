import type * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center border px-1.5 py-0.5 text-[9px] font-medium", { variants: { variant: {
  default: "border-border text-muted-foreground",
  accent: "border-accent/50 text-accent",
  destructive: "border-destructive/50 text-destructive",
  secondary: "border-border bg-muted text-muted-foreground",
} }, defaultVariants: { variant: "default" } });
export function Badge({ className, variant, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
export { badgeVariants };
