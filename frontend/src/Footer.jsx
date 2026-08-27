export default function Footer() {
  return (
    <footer className="w-full py-6 text-center text-sm text-slate-400 dark:text-slate-500">
      <p>Built and designed by Aviral Abel Willy.</p>
      <p>&copy; {new Date().getFullYear()} All rights reserved.</p>
    </footer>
  );
}