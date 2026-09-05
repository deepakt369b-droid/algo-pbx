import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-32 text-center">
      <h1 className="text-2xl font-semibold text-primary">Page not found</h1>
      <p className="mt-2 text-secondary">The page you&rsquo;re looking for doesn&rsquo;t exist.</p>
      <Link href="/" className="mt-6 text-accent hover:text-accent-hover">
        Back to home
      </Link>
    </div>
  );
}
