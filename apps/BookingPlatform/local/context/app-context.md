# BookingPlatform App Context

## Domain
This platform serves **outdoor bowls clubs** (lawn bowls, crown green bowls, flat green bowls).
It is **NOT** for tenpin bowling, indoor bowling, or any other variant.

## Domain Glossary
- **Green** — the outdoor grass or artificial playing surface owned by the club
- **Rink** — a defined strip of the green on which one game is played; multiple rinks run side-by-side on a green
- **End** — a round of play in one direction across the rink
- **Jack** — the small white target ball bowled to start each end
- **Mat** — the rubber mat from which the player delivers the bowl
- **Ditch** — the shallow trench surrounding the green boundary
- **Club** / **Tenant** — the bowling club that subscribes to the platform

## Platform overview
 - Platform to provide websites for bowling clubs across the globe.  Platform will obtain fees from clubs for the hosting and offer a wide range of features.  Clubs will have their own admins and ability to opt in/out of some features. At some future point, we will support the idea of 'federations', where members of a club can behave a thou hthey are members of a second club. Clubs will be able to configure their site to their own design via content management service within the platform and tailor fees/events/openng times. Clubs will be bale to advertise events on the website, and optionally make these visible to the public.  Similarly, clubs can opt in/out of disaplying events from other clubs on their website.


## Core Platform
- **Multi-tenant SaaS** — white-label bowling club platform with per-tenant branding, config, and data isolation
- **Tenant resolution** 
- **Role-based access** — `user`, `maintenance`, `tenant admin`, `platform admin`, `guest`
- **Neutral public landing** — anonymous users on `/` see platform-level neutral content with no tenant branding
- **Tenant experience after login** — authenticated users on `/` see their tenant-specific branding and content

## Booking System
- **Availability grid** — date picker → green/rink grid showing open/booked slots
- **Multi-green support** — each tenant configures N greens with M rinks each
- **Booking workflow** — `requested → approved → reserved → confirmed → cancelled/refunded`
- **Player fields** — per-rink player name capture
- **Waiting list** — users join waitlist for fully-booked slots, notified on cancellation
- **Season enforcement** — configurable season start/end dates, opening hours

## Payments
- **Pluggable payment engine**
- **Configurable stub** —for testing decline, insufficient funds, expired card, network errors
- **Booking payment flow** — admin confirms → checkout created → redirect to success → refund on cancel
- **Platform billing** — `TenantPayment` model for tenant invoicing (pending/paid/failed/refunded)

## Feature Flags
- **Per-tenant runtime toggles** 
- **Platform admin UI** 

Nt yet delivered in MVP

## Live Streaming
- **WebRTC broadcasting** admin/maintenance capture camera per rink
- **Viewer page**  peer-to-peer video via signaling API
- **Feature-gated** — entire streaming stack gated behind `liveStreaming` flag (server + client + nav)

## Chat Agent
- **ChatMessage model** stores messages with evaluation metadata
- **Evaluation engine**  — 8 keyword pattern categories ranked by severity
- **Auto task creation** — safety/facility/equipment/grounds/suggestion messages → maintenance tasks
- **Admin review dashboard**  — stats cards, category breakdown, filter tabs, mark-reviewed workflow

## Task Agent (Automation)
- **Rule engine**  — evaluates conditions against tasks, executes actions
- **Actions**: `auto_assign`, `escalate_priority`, `notify`, `add_note`, `close_stale`
- **Admin workflows UI**  — rule builder, activity log, stats, manual run

## Maintenance Module
- **Task management** — submit, assign, start, close, reopen with timestamped notes
- **7 categories** — general, rink surface, equipment, facilities, safety, grounds, other
- **Priority levels** — low, medium, high, urgent
- **Role-scoped views** — maintenance sees own tasks, admin sees all

## Messaging
- **Channels** — public, private, and group channels per tenant
- **Real-time messages** — user-to-user and group messaging
- **Admin channel management** 

## Content Management
- **Headless CMS** — landing page sections with draft → review → published → archived workflow
- **Section types** — hero, about, photo, map, contact with conditional fields
- **Toggle visibility** — enable/disable individual content blocks

## Events & Weather
- **Structured events** — cross-tenant event visibility
- **Weather integration**  — forecast display on booking page tied to venue lat/lng

## Progressive Web App
- **Installable PWA** — manifest, service worker, offline page, install prompt
- **Icons** — 192px and 512px SVG icons with maskable variant

Feature	Status
Multi-tenant + RBAC	✅ 100%
Authentication (login/register/reset)	✅ 100%
Feature Flags	✅ 100%
Payments (stub engine 	✅ 80% (stub only, no real provider)
Booking System	⚠️ 70% — no admin approval UI
Maintenance Module	⚠️ 75% — no auto-task creation from chat
Platform Admin	⚠️ 90% — no payments overview page
i18n	⚠️ 25% — locale field exists, no useTranslation() hook or translation files