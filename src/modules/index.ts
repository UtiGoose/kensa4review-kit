import type { CheckModule } from "../core/types";
import { endpointsModule } from "./endpoints";
import { flywayModule } from "./flyway";
import { gitleaksModule } from "./gitleaks";
import { hadolintModule } from "./hadolint";
import { gradleDepsModule, pmdModule, spotbugsModule } from "./jvm";
import { nginxModule } from "./nginx";
import { semgrepModule } from "./semgrep";
import { springConfigModule } from "./springConfig";
import { trivyModule } from "./trivy";

export const modules: CheckModule[] = [
  endpointsModule,
  springConfigModule,
  nginxModule,
  flywayModule,
  semgrepModule,
  gitleaksModule,
  trivyModule,
  hadolintModule,
  gradleDepsModule,
  spotbugsModule,
  pmdModule,
];
