import type { App } from "vue";
import type { UserSession } from "@toonflow/multi-tenant-user-web/types";
import http from "@/lib/http";
import { currentUser, publicWeb, hostWeb } from "@/stores/multiTenant";

export async function initializeMultiTenant(): Promise<{ session: UserSession; app: App<Element> | undefined }> {
  const session = await http<UserSession>({ method: "GET", url: "/api/multiTenant/user/session" });
  currentUser.value = session.user;
  publicWeb.value = false;
  hostWeb.value = false;
  return { session, app: undefined };
}
