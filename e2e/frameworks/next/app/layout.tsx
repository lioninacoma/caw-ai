import type { Metadata } from "next";
import Header from "@/lib/Header";

export const metadata: Metadata = { title: "caw Next" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        <Header />
        <main>{children}</main>
      </body>
    </html>
  );
}
