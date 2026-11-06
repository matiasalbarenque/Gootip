import { SocialButtons } from '@/components/auth/social-buttons';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardPanel,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';

export const SignInCard = () => {
  return (
    <Card className="w-full max-w-sm shadow-xl shadow-neutral-900/[0.06] ring-1 ring-black/[0.04] backdrop-blur animate-card-enter">
      <CardHeader className="items-center text-center">
        <div
          aria-hidden="true"
          className="flex size-10 items-center justify-center rounded-lg bg-primary font-semibold text-primary-foreground"
        >
          G
        </div>
        <CardTitle>Welcome back</CardTitle>
        <CardDescription>Sign in to your account to continue</CardDescription>
      </CardHeader>
      <CardPanel>
        <form action="#" className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              placeholder="you@example.com"
              required
              type="email"
              size="lg"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              placeholder="Your password"
              required
              type="password"
              size="lg"
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Checkbox id="remember-me" name="remember-me" />
              <Label htmlFor="remember-me">Remember me</Label>
            </div>
            <a
              className="text-sm font-medium underline-offset-4 hover:underline"
              href="#"
            >
              Forgot your password?
            </a>
          </div>
          <Button className="w-full" type="submit" size="lg">
            Continue
          </Button>
        </form>
        <div className="flex items-center gap-2 py-4">
          <Separator className="flex-1" />
          <span className="text-xs text-muted-foreground">Or</span>
          <Separator className="flex-1" />
        </div>
        <SocialButtons />
      </CardPanel>
      <CardFooter className="justify-center">
        <p className="text-sm text-muted-foreground">
          No account?{' '}
          <a
            className="font-medium text-foreground underline-offset-4 hover:underline"
            href="#"
          >
            Sign up
          </a>
        </p>
      </CardFooter>
    </Card>
  );
};
