import Link from 'next/link';
import { PageHeader } from '@/components/shell';

export default function NotFound() {
  return (
    <>
      <PageHeader title="Not found" description="That page or record does not exist, or you do not have access to it." />
      <Link href="/" className="btn-primary">Back to the dashboard</Link>
    </>
  );
}
