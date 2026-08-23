import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export const SelectGroup = SelectPrimitive.Group;
export const SelectLabel = SelectPrimitive.Label;
export const SelectTrigger = React.forwardRef<React.ComponentRef<typeof SelectPrimitive.Trigger>, React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>>(({ className, children, ...props }, ref) => <SelectPrimitive.Trigger ref={ref} className={cn("flex h-7 items-center justify-between gap-2 border border-border bg-muted/40 px-2 text-[10px] text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50", className)} {...props}>{children}<SelectPrimitive.Icon><ChevronDown className="size-3" /></SelectPrimitive.Icon></SelectPrimitive.Trigger>);
SelectTrigger.displayName = "SelectTrigger";
export const SelectContent = React.forwardRef<React.ComponentRef<typeof SelectPrimitive.Content>, React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>>(({ className, children, position = "popper", ...props }, ref) => <SelectPrimitive.Portal><SelectPrimitive.Content ref={ref} position={position} className={cn("z-50 min-w-[8rem] overflow-hidden border border-border bg-popover text-popover-foreground shadow-md", className)} {...props}><SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport></SelectPrimitive.Content></SelectPrimitive.Portal>);
SelectContent.displayName = "SelectContent";
export const SelectItem = React.forwardRef<React.ComponentRef<typeof SelectPrimitive.Item>, React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>>(({ className, children, ...props }, ref) => <SelectPrimitive.Item ref={ref} className={cn("relative flex cursor-default select-none items-center py-1.5 pl-7 pr-2 text-[10px] outline-none focus:bg-muted data-[disabled]:opacity-50", className)} {...props}><span className="absolute left-2"><SelectPrimitive.ItemIndicator><Check className="size-3" /></SelectPrimitive.ItemIndicator></span><SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText></SelectPrimitive.Item>);
SelectItem.displayName = "SelectItem";
