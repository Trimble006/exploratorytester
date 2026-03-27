# WL Booking — Feature Summary

## Core Platform
- **Multi-tenant SaaS** — white-label bowling club platform with per-tenant branding, config, and data isolation
- **Tenant resolution**
- **Role-based access** — `user`, `maintenance`, `admin`, `superadmin` 

## Booking System
- **Availability grid**
- **Multi-green support**
- **Booking workflow** 
- **Player fields**
- **Waiting list** —
- **Season enforcement**

## Payments
- **Pluggable payment engine** 
- **Configurable stub**
- **Booking payment flow** 
- **Platform billing** 

## Feature Flags
- **Per-tenant runtime toggles**
- **Platform admin UI**
- **Client hook** 
- **Flags**:

## Live Streaming
- **WebRTC broadcasting**
- **Viewer page**
- **Signal exchange** 
- **Feature-gated** 

## Chat Agent
- **ChatMessage model**
- **Evaluation engine**
- **Auto task creation**
- **Admin review dashboard** 

## Task Agent (Automation)
- **Rule engine**
- **Triggers**
- **Actions**
- **Admin workflows UI**

## Maintenance Module
- **Task management** — submit, assign, start, close, reopen with timestamped notes
- **7 categories** — general, rink surface, equipment, facilities, safety, grounds, other
- **Priority levels** — low, medium, high, urgent
- **Role-scoped views** — maintenance sees own tasks, admin sees all

## Messaging
- **Channels** — public, private, and group channels per tenant
- **Real-time messages** — user-to-user and group messaging
- **Admin channel management** (`app/admin/channels/page.tsx`)

## Content Management
- **Headless CMS** — landing page sections with draft → review → published → archived workflow
- **Section types** — hero, about, photo, map, contact with conditional fields
- **Toggle visibility** — enable/disable individual content blocks

## Events & Weather
- **Structured events** — cross-tenant event visibility
- **Weather integration** (`lib/weather.ts`) — forecast display on booking page tied to venue lat/lng

## Progressive Web App
- **Installable PWA** — manifest, service worker, offline page, install prompt
- **Icons** — 192px and 512px SVG icons with maskable variant

## Internationalisation
- **4 locales** — English, Welsh (Cymraeg), French, Scottish Gaelic

## Authentication
- **NextAuth v4** with credentials provider
- **Password reset** — token-based forgot/reset flow
- **Registration** with email/password

## Platform Admin (Superadmin)
- **Tenant CRUD** — create clubs with branding, greens, admin user, locale
- **Activate/deactivate** tenants on the fly
- **Feature flag toggles** per tenant
- **Platform payments overview**