import { LoginBackground } from '@/components/auth/login-background';
import { SignInCard } from '@/components/auth/sign-in-card';

const LoginPage = () => {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden p-4">
      <LoginBackground />
      <div className="relative z-10 flex w-full justify-center">
        <SignInCard />
      </div>
    </main>
  );
};

export default LoginPage;
