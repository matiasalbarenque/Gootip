import { randomUUID } from 'node:crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SsrHealthPage = () => {
  return (
    <main>
      <h1>SSR health check</h1>
      <code>{randomUUID()}</code>
    </main>
  );
};

export default SsrHealthPage;
