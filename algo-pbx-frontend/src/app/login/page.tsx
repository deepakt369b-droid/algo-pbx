import { LoginForm } from "./login-form";

export default function LoginPage({
  searchParams,
}: {
  searchParams: { callbackUrl?: string };
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-8">
      <LoginForm callbackUrl={searchParams.callbackUrl} />
    </main>
  );
}
