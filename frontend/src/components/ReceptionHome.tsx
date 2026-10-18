import type { LiveLanguage } from "@/features/live/types";
import { ReceptionHeroCarousel } from "./ReceptionHeroCarousel";
import "@/styles/reception-home.css";

type Props = { language: LiveLanguage };

const copy = {
  ja: {
    eyebrow: "ミライの会社",
    photoAlt: "明るいオフィスで、仲間と試作品について話し合うチームのイメージ",
    photoCaption: "AIと人が連携する、ミライの会社。",
    photoCredit: "写真はイメージです",
    servicesLabel: "この受付でできること",
    servicesTitle: "Webから始める、AI総合受付",
    servicesIntro: "採用の相談も、仕事の依頼も。",
    servicesFuture: "用件に合わせて、商談や問い合わせの受付にも拡張していきます。",
    services: [
      { title: "採用・応募の相談", example: "「どんな仕事を募集していますか？」" },
      { title: "仕事・作業の依頼", example: "「こんな仕事をお願いできますか？」" },
      { title: "人への確認・引き継ぎ", example: "AIに分からないことは、人に確認。" },
    ],
    storySummary: "HaaS：必要なときに、人の力を",
    storyLabel: "私たちについて",
    storyTitle: "採用受付で試す、ミライの会社",
    storyIntro: "私たちがつくるのは、株式会社HaaS。AIと人が連携する「ミライの会社」です。",
    storyMission: "Human as a Service.（ハース）\n人の力を呼び出せる会社を目指します。",
    rolesTitle: "AIと人の役割",
    roles: [
      ["AI", "採用相談や仕事の依頼の一次対応。"],
      ["人", "個別の条件や、例外的な相談への回答。"],
    ],
    handoff: "AIに分からないことは、人に確認する。",
    exampleTitle: "採用受付デモ：AIから、人へ",
    example: "Webから始める、AI採用受付。応募を考えたその場で、質問したい。担当者が、いつでも対応できるとは限らない。だから、AIが採用の問い合わせを受け止める。募集や応募について質問し、不明な点は、採用担当者に確認する。",
    values: "Webから気軽に質問できる使いやすさ。担当者が個別の相談に集中できる有用性。AIが必要なときに人の力を呼ぶ独創性。商談や問い合わせ対応にも展開することを目指しています。",
  },
  en: {
    eyebrow: "THE COMPANY OF TOMORROW",
    photoAlt: "An illustrative team discussing a prototype in a bright office",
    photoCaption: "A future where AI and people work together.",
    photoCredit: "Illustrative image",
    servicesLabel: "WHAT YOU CAN DO HERE",
    servicesTitle: "Your AI front desk, on the web",
    servicesIntro: "For job inquiries and work requests.",
    servicesFuture: "We plan to extend the reception to business conversations and other inquiries.",
    services: [
      { title: "Explore roles and applications", example: "“What positions are you hiring for?”" },
      { title: "Request work or a service", example: "“Could your team help with this project?”" },
      { title: "Connect with a person", example: "When the AI does not know, it checks with the team." },
    ],
    storySummary: "HaaS: a person, when it matters",
    storyLabel: "ABOUT US",
    storyTitle: "Exploring the company of tomorrow through recruiting",
    storyIntro: "We are building HaaS, a company where AI and people work together.",
    storyMission: "Human as a Service.\nA company that can call on human expertise when needed.",
    rolesTitle: "The roles of AI and people",
    roles: [
      ["AI", "Welcomes job inquiries and work requests."],
      ["People", "Answer individual questions and discuss exceptions."],
    ],
    handoff: "When the AI does not know, it checks with a person.",
    exampleTitle: "From AI to a person: the recruiting demo",
    example: "A recruiting contact is not always available. The AI introduces the roles, takes your questions and asks a person to check what it cannot answer.",
    values: "Easy to ask from the web. More time for the team to focus on individual questions. Human expertise when the AI needs it. We aim to extend this approach to business conversations and other inquiries.",
  },
};

export function ReceptionIntro({ language }: Props) {
  const c = copy[language];
  return (
    <div className="reception-intro haas-intro">
      <p className="eyebrow">{c.eyebrow}</p>
      <h1 lang="en" className="haas-headline-concept"><span>H</span>uman <span>a</span>s <span>a</span> <span>S</span>ervice.</h1>
    </div>
  );
}

export function ReceptionOffice({ language }: Props) {
  return <ReceptionHeroCarousel language={language} />;
}

export function ReceptionCapabilities({ language }: Props) {
  const c = copy[language];
  return (
    <section className="haas-capabilities" aria-labelledby="haas-services-title">
      <div className="haas-section-intro">
        <div>
          <p className="eyebrow">{c.servicesLabel}</p>
          <h2 id="haas-services-title">{c.servicesTitle}</h2>
        </div>
        <p>{c.servicesIntro}</p>
      </div>
      <ol className="haas-services">
        {c.services.map((service, index) => (
          <li key={index}>
            <span className="haas-service-number" aria-hidden="true">0{index + 1}</span>
            <div><h3>{service.title}</h3><p>{service.example}</p></div>
          </li>
        ))}
      </ol>
      <p className="haas-services-future">{c.servicesFuture}</p>
      <details className="haas-story">
        <summary><span>{c.storySummary}</span><span className="haas-story-link">{c.storyLabel}</span></summary>
        <div className="haas-story-content">
          <div><h3>{c.storyTitle}</h3><p>{c.storyIntro}</p><p>{c.storyMission}</p></div>
          <div>
            <h3>{c.rolesTitle}</h3>
            <dl>{c.roles.map(([role, description]) => <div key={role}><dt>{role}</dt><dd>{description}</dd></div>)}</dl>
            <p>{c.handoff}</p>
          </div>
          <div><h3>{c.exampleTitle}</h3><p>{c.example}</p></div>
          <p className="haas-values">{c.values}</p>
        </div>
      </details>
    </section>
  );
}
