import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

export const Tabs = TabsPrimitive.Root;
export const TabsList = React.forwardRef<React.ComponentRef<typeof TabsPrimitive.List>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>>(({ className, ...props }, ref) =>
  <TabsPrimitive.List ref={ref} className={cn("inline-flex border border-border", className)} {...props} />);
TabsList.displayName = "TabsList";
export const TabsTrigger = React.forwardRef<React.ComponentRef<typeof TabsPrimitive.Trigger>, React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>>(({ className, ...props }, ref) =>
  <TabsPrimitive.Trigger ref={ref} className={cn("px-2 py-1 text-[9px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=active]:bg-muted data-[state=active]:text-foreground", className)} {...props} />);
TabsTrigger.displayName = "TabsTrigger";
export const TabsContent = TabsPrimitive.Content;
