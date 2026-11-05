import { Link, Route, Routes } from "react-router-dom";

import { Footer, Header } from "./components/Header";
import { EmptyState } from "./components/ui";
import { Create } from "./pages/Create";
import { Explore } from "./pages/Explore";
import { HowItWorks } from "./pages/HowItWorks";
import { Portfolio } from "./pages/Portfolio";
import { Token } from "./pages/Token";

export function App() {
  return (
    <div className="app">
      <Header />
      <main className="main">
        <Routes>
          <Route path="/" element={<Explore />} />
          <Route path="/create" element={<Create />} />
          <Route path="/portfolio" element={<Portfolio />} />
          <Route path="/how-it-works" element={<HowItWorks />} />
          <Route path="/token/:address" element={<Token />} />
          <Route
            path="*"
            element={
              <div className="container page">
                <EmptyState title="Page not found" action={<Link to="/" className="btn btn-secondary btn-sm">Back to tokens</Link>} />
              </div>
            }
          />
        </Routes>
      </main>
      <Footer />
    </div>
  );
}
