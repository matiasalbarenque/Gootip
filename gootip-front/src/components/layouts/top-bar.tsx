'use client';

import { Menu, Search, User } from 'lucide-react';
import Link from 'next/link';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/menu';

export const TopBar = () => {
  return (
    <header className="sticky top-0 z-50 border-b px-4 bg-lime-100">
      <div className="flex h-16 items-center gap-4">
        <div className="flex shrink-0 items-center">
          <Button
            aria-label="Open menu"
            size="icon"
            type="button"
            variant="ghost"
          >
            <Menu />
          </Button>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="relative w-full max-w-md">
            <Input
              aria-label="Search products"
              placeholder="Search products…"
              type="search"
            />
            <Search className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" />
          </div>
        </div>
        <div className="flex shrink-0 items-center">
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Account"
              className="flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Avatar className="border border-gray-300">
                <AvatarFallback aria-hidden="true">
                  <User className="size-4" />
                </AvatarFallback>
              </Avatar>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem render={<Link href="/login" />}>
                Sign in
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/login" />}>
                Sign up
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
};
