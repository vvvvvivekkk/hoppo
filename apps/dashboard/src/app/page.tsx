import { redirect } from 'next/navigation';

/** The order queue is the reason this app exists, so it is the front door. */
export default function Home() {
  redirect('/orders');
}
