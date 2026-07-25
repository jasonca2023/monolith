import React, { useState } from "react";

/**
 * Everything else in Monolith works with no account at all — this is purely
 * so session history and mood schedules follow you to another machine.
 */
export default function AccountModal({
  onSignedIn,
  onDismiss,
}: {
  onSignedIn: (email: string) => void;
  onDismiss: () => void;
}): React.JSX.Element {
  const [mode, setMode] = useState<"sign-in" | "create">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async () => {
    const api = window.monolith;
    if (!api) return;

    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      const result =
        mode === "sign-in" ? await api.signIn(email, password) : await api.signUp(email, password);

      if (!result.ok) {
        setError(result.detail);
        return;
      }

      if (mode === "create") {
        // Supabase requires email confirmation before a session exists.
        setNotice(result.detail);
        setMode("sign-in");
        return;
      }

      onSignedIn(email);
    } catch (cause) {
      setError(`Couldn't reach the cloud: ${String(cause)}`);
    } finally {
      setWorking(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-title"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
    >
      <div className="app-no-drag w-full max-w-sm rounded-2xl border border-[#1e1e1e] bg-[#0d0d12] p-6 shadow-2xl sm:p-8">
        <h2 id="account-title" className="text-xl font-semibold text-slate-100">
          {mode === "sign-in" ? "Sign in" : "Create an account"}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          Saves your session history and mood schedules so they follow you to another machine.
          Everything else already works without this.
        </p>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="mt-6 flex flex-col gap-3"
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-slate-500">Email</span>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="rounded-lg border border-[#242430] bg-black/60 px-3 py-2 text-sm text-slate-200 outline-none transition focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400/40"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-slate-500">Password</span>
            <input
              type="password"
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              required
              minLength={6}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="rounded-lg border border-[#242430] bg-black/60 px-3 py-2 text-sm text-slate-200 outline-none transition focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400/40"
            />
          </label>

          {notice && <p className="text-sm text-emerald-400">{notice}</p>}
          {error && (
            <p role="alert" className="text-sm text-red-400">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={working}
            className="mt-2 rounded-full bg-indigo-500 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-300"
          >
            {working ? "Working…" : mode === "sign-in" ? "Sign in" : "Create account"}
          </button>
        </form>

        <div className="mt-5 flex items-center justify-between text-xs">
          <button
            type="button"
            onClick={() => {
              setMode((m) => (m === "sign-in" ? "create" : "sign-in"));
              setError(null);
              setNotice(null);
            }}
            className="text-slate-500 underline decoration-slate-700 underline-offset-2 transition hover:text-slate-300"
          >
            {mode === "sign-in" ? "Need an account? Create one" : "Have an account? Sign in"}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="text-slate-500 transition hover:text-slate-300"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
