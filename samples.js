/* Example JSON:API documents used by the "Load example" menu. */
(function () {
  "use strict";

  window.Lens = window.Lens || {};

  window.Lens.examples = {
    deep: {
      jsonapi: { version: "1.0" },
      links: {
        self: "https://api.example.com/articles",
        next: "https://api.example.com/articles?page[number]=2"
      },
      meta: { total: 2, requestId: "req_8f2c41" },
      data: [
        {
          type: "articles",
          id: "1",
          attributes: {
            title: "JSON:API paints my bikeshed!",
            body: "The shortest article. Ever. But with the deepest relationships.",
            wordCount: 412,
            published: true,
            publishedAt: "2024-05-01T09:30:00Z",
            keywords: ["jsonapi", "serialization"]
          },
          relationships: {
            author: {
              links: { related: "/articles/1/author", self: "/articles/1/relationships/author" },
              data: { type: "people", id: "9" }
            },
            editor: { links: { related: "/articles/1/editor" } },
            comments: {
              data: [
                { type: "comments", id: "5" },
                { type: "comments", id: "12" }
              ]
            },
            tags: {
              data: [
                { type: "tags", id: "science" },
                { type: "tags", id: "jsonapi" }
              ]
            },
            cover: { data: null }
          },
          links: { self: "/articles/1" },
          meta: { revision: 3 }
        },
        {
          type: "articles",
          id: "2",
          attributes: {
            title: "Deep linking, explained",
            body: "A second primary resource so the collection view has company.",
            wordCount: 260,
            published: false,
            publishedAt: null
          },
          relationships: {
            author: { data: { type: "people", id: "2" } },
            comments: { data: [] },
            tags: { data: [{ type: "tags", id: "jsonapi" }] }
          },
          links: { self: "/articles/2" }
        }
      ],
      included: [
        {
          type: "people",
          id: "9",
          attributes: {
            name: "Dan Gebhardt",
            role: "Maintainer",
            email: "dan@example.com",
            social: { github: "dgeb", twitter: "dgeb" }
          },
          relationships: {
            employer: { data: { type: "companies", id: "1" } },
            reportsTo: { data: { type: "people", id: "2" } },
            articles: { data: [{ type: "articles", id: "1" }] }
          },
          links: { self: "/people/9" }
        },
        {
          type: "people",
          id: "2",
          attributes: {
            name: "Jane Doe",
            role: "Editor",
            email: "jane@example.com"
          },
          relationships: {
            employer: { data: { type: "companies", id: "1" } },
            reportsTo: { data: { type: "people", id: "9" } },
            articles: { data: [{ type: "articles", id: "2" }] }
          }
        },
        {
          type: "companies",
          id: "1",
          attributes: {
            name: "Example Org",
            domain: "example.com",
            founded: 2014,
            location: { city: "Boston", country: "US" }
          },
          relationships: {
            owner: { data: { type: "people", id: "2" } },
            foundedBy: { data: { type: "people", id: "9" } },
            employees: {
              data: [
                { type: "people", id: "9" },
                { type: "people", id: "2" }
              ]
            }
          },
          links: { self: "/companies/1" }
        },
        {
          type: "comments",
          id: "5",
          attributes: { body: "First!", createdAt: "2024-05-02T10:00:00Z" },
          relationships: {
            author: { data: { type: "people", id: "2" } },
            article: { data: { type: "articles", id: "1" } }
          }
        },
        {
          type: "comments",
          id: "12",
          attributes: { body: "I like XML better", createdAt: "2024-05-03T11:20:00Z" },
          relationships: {
            author: { data: { type: "people", id: "9" } },
            article: { data: { type: "articles", id: "1" } }
          }
        },
        {
          type: "tags",
          id: "science",
          attributes: { name: "science", color: "#7c3aed" },
          relationships: { articles: { data: [{ type: "articles", id: "1" }] } }
        },
        {
          type: "tags",
          id: "jsonapi",
          attributes: { name: "jsonapi", color: "#0ea5e9" },
          relationships: {
            articles: {
              data: [
                { type: "articles", id: "1" },
                { type: "articles", id: "2" }
              ]
            }
          }
        }
      ]
    },

    violations: {
      jsonapi: { version: "2.0" },
      debug: true,
      data: [
        {
          type: "articles",
          id: 1,
          attributes: { title: "Numeric ids are invalid", id: "reserved field name" },
          relationships: {
            author: { data: { type: "people", id: "9" } },
            tags: {}
          }
        },
        {
          type: "articles",
          id: "1",
          attributes: { title: "Duplicate primary resource" },
          relationships: { author: { data: { type: "people", id: "9" } } }
        },
        {
          type: "articles",
          id: "3",
          lid: "local-3",
          attributes: { title: "id and lid together" }
        }
      ],
      included: [
        { type: "people", id: "9", attributes: { name: "Dan" } },
        { type: "people", id: "9", attributes: { name: "Dan (duplicate)" } },
        { type: "tags", id: "orphan", attributes: { name: "Nobody links to me" } }
      ],
      meta: "meta should be an object",
      errors: [{ detail: "data and errors must not coexist" }]
    },

    errors: {
      jsonapi: { version: "1.1" },
      errors: [
        {
          status: "422",
          code: "invalid-attribute",
          title: "Invalid attribute",
          detail: "Email is not a valid address.",
          source: { pointer: "/data/attributes/email" }
        },
        {
          status: "404",
          code: "not-found",
          title: "Article not found",
          detail: "No article exists with id 99.",
          links: { about: "https://example.com/errors/404" }
        }
      ],
      meta: { requestId: "req_01HZX4" }
    },

    minimal: {
      data: {
        type: "articles",
        id: "1",
        attributes: { title: "Hello, JSON:API" }
      }
    }
  };
})();
