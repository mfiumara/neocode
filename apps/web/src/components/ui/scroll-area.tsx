import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { cn } from "@/lib/utils";

export interface ScrollAreaProps extends React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> {
  viewportRef?: React.Ref<HTMLDivElement>;
  viewportClassName?: string;
  onViewportScroll?: React.UIEventHandler<HTMLDivElement>;
}
export const ScrollArea = React.forwardRef<React.ComponentRef<typeof ScrollAreaPrimitive.Root>, ScrollAreaProps>(({ className, children, viewportRef, viewportClassName, onViewportScroll, ...props }, ref) =>
  <ScrollAreaPrimitive.Root ref={ref} className={cn("relative overflow-hidden", className)} {...props}>
    <ScrollAreaPrimitive.Viewport ref={viewportRef} onScroll={onViewportScroll} className={cn("size-full rounded-[inherit]", viewportClassName)}>{children}</ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>);
ScrollArea.displayName = "ScrollArea";
export const ScrollBar = React.forwardRef<React.ComponentRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>, React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>>(({ className, orientation = "vertical", ...props }, ref) =>
  <ScrollAreaPrimitive.ScrollAreaScrollbar ref={ref} orientation={orientation} className={cn("flex touch-none select-none p-px transition-colors", orientation === "vertical" ? "h-full w-2 border-l border-l-transparent" : "h-2 flex-col border-t border-t-transparent", className)} {...props}><ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" /></ScrollAreaPrimitive.ScrollAreaScrollbar>);
ScrollBar.displayName = "ScrollBar";
