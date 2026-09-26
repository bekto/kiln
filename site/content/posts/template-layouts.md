---
title: Template Layouts
date: 2026-02-14
tags: [reference]
---

Layouts are HTML templates with a few template-language tags. The example
site ships three of them — `base.html`, `index.html`, and `post.html` —
plus a `partials/` folder for reusable fragments.

## How a document picks a layout

A document renders through the template its frontmatter names, falling
back to the post layout when none is set. `index.html` declares its own:

```html
---
layout: index
---
```

In the template itself, the chain is ordinary template inheritance:

```html
{% extends "base.html" %}
{% block content %}
<h1>{{ page.title }}</h1>
{{ content | safe }}
{% endblock %}
```

`base.html` owns the document head — the Atom feed link, the stylesheets,
the navigation and search box — while every other layout fills the
content block.

## Partials

Small fragments live in `templates/partials/` and are pulled in by bare
name. The navigation embeds the search widget with a single include, and
the table of contents on this very page comes from a partial too.

## Strict by default

A typo like `{{ titel }}` fails the build with the template name and line
number instead of shipping an empty heading.
