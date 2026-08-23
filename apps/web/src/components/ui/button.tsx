import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-sm text-sm font-medium transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
  { variants: { variant: {
    default: "border border-accent/60 bg-transparent text-accent hover:bg-accent/10",
    destructive: "border border-destructive/60 bg-transparent text-destructive hover:bg-destructive/10",
    outline: "border border-border bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
    ghost: "bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
  }, size: { default: "h-8 px-3", sm: "h-7 px-2 text-xs", icon: "size-7" } }, defaultVariants: { variant: "default", size: "default" } },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, ...props }, ref) =>
  <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />);
Button.displayName = "Button";
export { buttonVariants };
