import { useAuth } from "../context/AuthContext";

export function LoginPage() {
  const { login } = useAuth();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 dark:bg-zinc-950 px-4">
      <div className="text-center space-y-6 max-w-xs w-full">
        <div>
          <p className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Estate Sales
          </p>
          <p className="mt-1 text-sm text-zinc-500">Sign in to access your dashboard</p>
        </div>
        <button
          onClick={() => login()}
          className="w-full rounded-full bg-zinc-900 px-6 py-3 text-sm font-medium text-white transition-opacity hover:opacity-80 dark:bg-zinc-100 dark:text-zinc-900"
        >
          Sign in with Authentik
        </button>
      </div>
    </div>
  );
}
