import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogOverlay = React.forwardRef<React.ComponentRef<typeof DialogPrimitive.Overlay>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>>(({ className, ...props }, ref) =>
  <DialogPrimitive.Overlay ref={ref} className={cn("fixed inset-0 z-50 bg-black/75 data-[state=open]:animate-in data-[state=closed]:animate-out", className)} {...props} />);
DialogOverlay.displayName = "DialogOverlay";
export const DialogContent = React.forwardRef<React.ComponentRef<typeof DialogPrimitive.Content>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideClose?: boolean }>(({ className, children, hideClose, ...props }, ref) =>
  <DialogPortal><DialogOverlay /><DialogPrimitive.Content ref={ref} className={cn("fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 border border-border bg-popover text-popover-foreground shadow-xl outline-none", className)} {...props}>{children}{!hideClose && <DialogPrimitive.Close className="absolute right-3 top-3 rounded-sm p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"><X className="size-4"/><span className="sr-only">Close</span></DialogPrimitive.Close>}</DialogPrimitive.Content></DialogPortal>);
DialogContent.displayName = "DialogContent";
export const DialogTitle = React.forwardRef<React.ComponentRef<typeof DialogPrimitive.Title>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>>(({ className, ...props }, ref) => <DialogPrimitive.Title ref={ref} className={cn("text-sm font-medium", className)} {...props} />);
DialogTitle.displayName = "DialogTitle";
export const DialogDescription = React.forwardRef<React.ComponentRef<typeof DialogPrimitive.Description>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>>(({ className, ...props }, ref) => <DialogPrimitive.Description ref={ref} className={cn("text-xs text-muted-foreground", className)} {...props} />);
DialogDescription.displayName = "DialogDescription";
