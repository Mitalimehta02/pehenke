import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getApp } from "@/lib/server/app";
import ChatApp from "./ChatApp";

export const dynamic = "force-dynamic";

async function sellerFor(slug: string) {
  return (await getApp()).prisma.seller.findUnique({ where: { slug }, select: { name: true, slug: true } });
}

export async function generateMetadata({ params }: PageProps<"/chat/[sellerSlug]">): Promise<Metadata> {
  const seller = await sellerFor((await params).sellerSlug);
  return { title: seller ? `${seller.name} · Try it on` : "Shop not found" };
}

export default async function ChatPage({ params }: PageProps<"/chat/[sellerSlug]">) {
  const seller = await sellerFor((await params).sellerSlug);
  if (!seller) notFound();
  return <ChatApp sellerSlug={seller.slug} sellerName={seller.name} />;
}
