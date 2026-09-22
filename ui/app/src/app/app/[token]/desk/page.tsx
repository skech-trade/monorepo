import { notFound, redirect } from "next/navigation";
import { marketFor } from "@/lib/market";
export default async function DeskPage({params}:{params:Promise<{token:string}>}) {
  const {token}=await params;if(!marketFor(token))notFound();
  redirect(`/app/${token}`);
}
