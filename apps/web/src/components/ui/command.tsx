import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

export const Command = React.forwardRef<React.ComponentRef<typeof CommandPrimitive>, React.ComponentPropsWithoutRef<typeof CommandPrimitive>>(({ className, ...props }, ref) => <CommandPrimitive ref={ref} className={cn("flex h-full w-full flex-col overflow-hidden bg-popover text-popover-foreground", className)} {...props} />);
Command.displayName = "Command";
export function CommandDialog({ title = "Command palette", description = "Search threads, workers, and commands", children, className, ...props }: React.ComponentProps<typeof Dialog> & { title?: string; description?: string; children: React.ReactNode; className?: string }) {
  return <Dialog {...props}><DialogContent hideClose className={cn("top-[12vh] translate-y-0 overflow-hidden p-0", className)}><DialogTitle className="sr-only">{title}</DialogTitle><DialogDescription className="sr-only">{description}</DialogDescription>{children}</DialogContent></Dialog>;
}
export const CommandInput = React.forwardRef<React.ComponentRef<typeof CommandPrimitive.Input>, React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>>(({ className, ...props }, ref) => <div className="flex items-center border-b border-border px-3"><Search className="mr-2 size-4 shrink-0 text-muted-foreground" /><CommandPrimitive.Input ref={ref} className={cn("h-11 w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground disabled:opacity-50", className)} {...props} /></div>);
CommandInput.displayName = "CommandInput";
export const CommandList = React.forwardRef<React.ComponentRef<typeof CommandPrimitive.List>, React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>>(({ className, ...props }, ref) => <CommandPrimitive.List ref={ref} className={cn("max-h-[400px] overflow-y-auto overflow-x-hidden p-1", className)} {...props} />);
CommandList.displayName = "CommandList";
export const CommandEmpty = CommandPrimitive.Empty;
export const CommandGroup = React.forwardRef<React.ComponentRef<typeof CommandPrimitive.Group>, React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>>(({ className, ...props }, ref) => <CommandPrimitive.Group ref={ref} className={cn("overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[9px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-muted-foreground", className)} {...props} />);
CommandGroup.displayName = "CommandGroup";
export const CommandItem = React.forwardRef<React.ComponentRef<typeof CommandPrimitive.Item>, React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>>(({ className, ...props }, ref) => <CommandPrimitive.Item ref={ref} className={cn("relative flex cursor-default select-none items-center px-2 py-2 text-[10px] outline-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-muted", className)} {...props} />);
CommandItem.displayName = "CommandItem";
export const CommandSeparator = CommandPrimitive.Separator;
