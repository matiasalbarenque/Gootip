export const LoginBackground = () => {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden bg-[#fafaf9]"
    >
      {/* soft base wash */}
      <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_0%,#ffffff_0%,#f5f5f4_45%,#e7e5e4_100%)]" />

      {/* drifting pastel blobs */}
      <div className="absolute -top-32 -left-24 size-[34rem] rounded-full bg-emerald-200/40 blur-3xl animate-aurora-1" />
      <div className="absolute top-1/3 -right-32 size-[38rem] rounded-full bg-sky-200/40 blur-3xl animate-aurora-2" />
      <div className="absolute -bottom-40 left-1/4 size-[36rem] rounded-full bg-amber-100/60 blur-3xl animate-aurora-3" />
      <div className="absolute top-1/4 left-1/2 size-[28rem] -translate-x-1/2 rounded-full bg-rose-100/40 blur-3xl animate-aurora-2" />

      {/* subtle grid */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(0,0,0,0.035)_1px,transparent_1px),linear-gradient(to_bottom,rgba(0,0,0,0.035)_1px,transparent_1px)] bg-[size:56px_56px] [mask-image:radial-gradient(70%_60%_at_50%_40%,black_30%,transparent_100%)]" />

      {/* vignette to keep card readable */}
      <div className="absolute inset-0 bg-[radial-gradient(60%_55%_at_50%_50%,transparent_40%,rgba(0,0,0,0.06)_100%)]" />
    </div>
  );
};
