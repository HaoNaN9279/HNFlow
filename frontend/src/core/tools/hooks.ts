import { useQuery } from "@tanstack/react-query";

import { loadTools } from "./api";

export function useTools() {
  return useQuery({
    queryKey: ["tools"],
    queryFn: loadTools,
  });
}
