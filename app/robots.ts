import { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/auth/", "/dashboard/"],
    },
    sitemap: "https://www.subai.co.il/sitemap.xml",
  };
}
