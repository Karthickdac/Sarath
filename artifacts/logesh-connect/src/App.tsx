import { useState, useEffect } from "react";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LeaderConfigProvider, useLeaderConfig } from "@/lib/LeaderConfigContext";
import { PageLayout } from "@/components/PageLayout";
import type { Language } from "@/lib/i18n";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import { getToken } from "@/lib/auth";

// Wire up JWT so all generated API hooks include Authorization: Bearer <token>
setAuthTokenGetter(() => getToken());

import Home from "@/pages/Home";
import About from "@/pages/About";
import News from "@/pages/News";
import NewsDetail from "@/pages/NewsDetail";
import Events from "@/pages/Events";
import EventDetail from "@/pages/EventDetail";
import Gallery from "@/pages/Gallery";
import Activities from "@/pages/Activities";
import Volunteer from "@/pages/Volunteer";
import Grievance from "@/pages/Grievance";
import Appointment from "@/pages/Appointment";
import Contact from "@/pages/Contact";
import Login from "@/pages/Login";
import Admin from "@/pages/Admin";
import Faq from "@/pages/Faq";
import Achievements from "@/pages/Achievements";
import Promises from "@/pages/Promises";
import Diary from "@/pages/Diary";
import MapPage from "@/pages/MapPage";
import { Journey, Development, Welfare, PressReleases, Donate, Emergency } from "@/pages/SimplePages";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

function ScrollToTop() {
  const [location] = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [location]);
  return null;
}

function SiteMetaManager() {
  const lc = useLeaderConfig();
  useEffect(() => {
    if (lc.siteTitle) {
      document.title = `${lc.siteTitleTa || lc.siteTitle} | ${lc.nameTa || lc.nameEn}`;
    }
  }, [lc.siteTitle, lc.siteTitleTa, lc.nameTa, lc.nameEn]);
  useEffect(() => {
    if (!lc.photoUrl) return;
    const link32 = document.querySelector<HTMLLinkElement>("link[sizes='32x32']");
    const link512 = document.querySelector<HTMLLinkElement>("link[sizes='512x512']");
    const apple = document.querySelector<HTMLLinkElement>("link[rel='apple-touch-icon']");
    if (link32) link32.href = lc.photoUrl;
    if (link512) link512.href = lc.photoUrl;
    if (apple) apple.href = lc.photoUrl;
  }, [lc.photoUrl]);
  return null;
}

function PublicRoutes({ lang, setLang, darkMode, setDarkMode }: {
  lang: Language;
  setLang: (l: Language) => void;
  darkMode: boolean;
  setDarkMode: (v: boolean) => void;
}) {
  return (
    <PageLayout lang={lang} setLang={setLang} darkMode={darkMode} setDarkMode={setDarkMode}>
      <Switch>
        <Route path="/" component={() => <Home lang={lang} />} />
        <Route path="/about" component={() => <About lang={lang} />} />
        <Route path="/journey" component={() => <Journey lang={lang} />} />
        <Route path="/development" component={() => <Development lang={lang} />} />
        <Route path="/news" component={() => <News lang={lang} />} />
        <Route path="/news/:id" component={({ params }) => <NewsDetail lang={lang} id={params.id} />} />
        <Route path="/activities" component={() => <Activities lang={lang} />} />
        <Route path="/events" component={() => <Events lang={lang} />} />
        <Route path="/events/:id" component={({ params }) => <EventDetail lang={lang} id={params.id} />} />
        <Route path="/press" component={() => <PressReleases lang={lang} />} />
        <Route path="/gallery" component={() => <Gallery lang={lang} />} />
        <Route path="/achievements" component={() => <Achievements lang={lang} />} />
        <Route path="/promises" component={() => <Promises lang={lang} />} />
        <Route path="/diary" component={() => <Diary lang={lang} />} />
        <Route path="/welfare" component={() => <Welfare lang={lang} />} />
        <Route path="/map" component={() => <MapPage lang={lang} />} />
        <Route path="/grievance" component={() => <Grievance lang={lang} />} />
        <Route path="/appointment" component={() => <Appointment lang={lang} />} />
        <Route path="/contact" component={() => <Contact lang={lang} />} />
        <Route path="/volunteer" component={() => <Volunteer lang={lang} />} />
        <Route path="/donate" component={() => <Donate lang={lang} />} />
        <Route path="/faq" component={() => <Faq lang={lang} />} />
        <Route path="/emergency" component={() => <Emergency lang={lang} />} />
        <Route component={NotFound} />
      </Switch>
    </PageLayout>
  );
}

function Router({ lang, setLang, darkMode, setDarkMode }: {
  lang: Language;
  setLang: (l: Language) => void;
  darkMode: boolean;
  setDarkMode: (v: boolean) => void;
}) {
  return (
    <>
      <ScrollToTop />
      <Switch>
        <Route path="/login" component={() => <Login />} />
        <Route path="/admin" component={() => <Admin lang={lang} setLang={setLang} />} />
        <Route component={() => (
          <PublicRoutes lang={lang} setLang={setLang} darkMode={darkMode} setDarkMode={setDarkMode} />
        )} />
      </Switch>
    </>
  );
}

export default function App() {
  const [lang, setLang] = useState<Language>("ta");
  const [darkMode, setDarkMode] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("nirmal_theme");
    if (stored === "dark") setDarkMode(true);
    const storedLang = localStorage.getItem("nc.lang");
    if (storedLang === "en" || storedLang === "ta") setLang(storedLang);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
    localStorage.setItem("nirmal_theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  useEffect(() => {
    document.documentElement.lang = lang;
    localStorage.setItem("nc.lang", lang);
  }, [lang]);

  return (
    <QueryClientProvider client={queryClient}>
      <LeaderConfigProvider>
        <SiteMetaManager />
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router lang={lang} setLang={setLang} darkMode={darkMode} setDarkMode={setDarkMode} />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </LeaderConfigProvider>
    </QueryClientProvider>
  );
}
